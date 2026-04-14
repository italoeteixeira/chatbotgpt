import express from 'express';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { botDatabase } from './botDatabase.js';
import { config } from './config.js';
import { getRecentLogs, logEvents, logger } from './logger.js';
import { getRuntimeState, stateEvents, updateRuntimeState } from './runtimeState.js';
import { settingsStore } from './settingsStore.js';
import { mediaStore } from './mediaStore.js';
import { listRecentConversationEntries } from './conversationStore.js';
import {
  accessControl,
  normalizeGroupId as normalizeAccessGroup,
  normalizePhoneNumber as normalizeAccessPhone
} from './accessControl.js';
import { fullAutoJobEvents, getFullAutoJobsSnapshot, listFullAutoJobs } from './fullAutoJobStore.js';
import { panelAuth } from './panelAuth.js';
import { getCodexCircuitStatus } from './codexBridge.js';
import { buildLocalPanelUrl, resolvePanelAccessInfo } from './panelUrl.js';

const AI_REASONING_EFFORT_OPTIONS = Object.freeze(['low', 'medium', 'high', 'xhigh']);
const AI_PROVIDER_MODEL_MATRIX = Object.freeze({
  copilot: ['gpt-5-mini', 'gpt-4.1', 'gpt-5', 'claude-sonnet-4.6', 'claude-3.7-sonnet'],
  codex: ['gpt-5.4-mini', 'gpt-5.4', 'gpt-5-mini', 'gpt-5']
});
const AI_PROVIDER_PROBE_CACHE_MAX_AGE_MS = 10 * 60 * 1000;

let aiProviderProbeCache = null;

function sseEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function parseIntSafe(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parseBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (['true', '1', 'yes', 'sim', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'nao', 'não', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeModelAlias(providerId, mode, rawValue, runtime = {}) {
  const raw = String(rawValue || '').trim();
  if (!raw) return '';

  const compact = raw
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/_/g, '-');

  const copilotPrimary = String(runtime.copilotModel || config.copilotModel || 'gpt-5-mini').trim() || 'gpt-5-mini';
  const copilotFull = String(runtime.copilotFullModel || copilotPrimary).trim() || copilotPrimary;
  const copilotFallback = String(runtime.copilotFallbackModel || config.copilotFallbackModel || 'gpt-4.1').trim() || 'gpt-4.1';
  const codexPrimary = String(runtime.codexModel || config.codexModel || 'gpt-5.4-mini').trim() || 'gpt-5.4-mini';
  const codexFallback = String(runtime.codexFallbackModel || config.codexFallbackModel || 'gpt-5.4').trim() || 'gpt-5.4';

  if (['gpt', 'chatgpt', 'openai'].includes(compact)) {
    if (providerId === 'copilot') {
      if (mode === 'fallback') return copilotFallback;
      return mode === 'full' ? copilotFull : copilotPrimary;
    }
    if (mode === 'fallback') return codexFallback;
    return codexPrimary;
  }

  if (['gpt5', 'gpt-5', 'gptmini', 'gpt-mini', 'gpt5mini', 'gpt-5-mini'].includes(compact)) {
    return providerId === 'copilot' ? 'gpt-5-mini' : codexPrimary;
  }

  if (['gpt4', 'gpt-4', 'gpt4.1', 'gpt-4.1'].includes(compact)) {
    return providerId === 'copilot' ? 'gpt-4.1' : codexFallback;
  }

  return raw;
}

function normalizeModelPatch(patch, runtime = {}) {
  if (!patch || typeof patch !== 'object') return {};
  const normalized = { ...patch };

  if ('copilotModel' in normalized) {
    normalized.copilotModel = normalizeModelAlias('copilot', 'normal', normalized.copilotModel, runtime);
  }
  if ('copilotFullModel' in normalized) {
    normalized.copilotFullModel = normalizeModelAlias('copilot', 'full', normalized.copilotFullModel, runtime);
  }
  if ('copilotFallbackModel' in normalized) {
    normalized.copilotFallbackModel = normalizeModelAlias('copilot', 'fallback', normalized.copilotFallbackModel, runtime);
  }
  if ('codexModel' in normalized) {
    normalized.codexModel = normalizeModelAlias('codex', 'normal', normalized.codexModel, runtime);
  }
  if ('codexFallbackModel' in normalized) {
    normalized.codexFallbackModel = normalizeModelAlias('codex', 'fallback', normalized.codexFallbackModel, runtime);
  }

  return normalized;
}

function extractSerializedWid(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    if (typeof value._serialized === 'string') return value._serialized;
    if (typeof value.user === 'string' && typeof value.server === 'string') return `${value.user}@${value.server}`;
    if (value.id) return extractSerializedWid(value.id);
  }
  return '';
}

function isGroupParticipantAdmin(participant) {
  return Boolean(participant?.isAdmin || participant?.isSuperAdmin || participant?.type === 'admin' || participant?.type === 'superadmin');
}

function normalizeWidDigits(value) {
  const serialized = extractSerializedWid(value);
  if (!serialized) return '';
  return normalizeAccessPhone(serialized.split('@')[0] || '');
}

function participantMatchesBot(participant, botSerialized, botDigits) {
  const participantSerialized = extractSerializedWid(participant?.id || participant);
  if (!participantSerialized) return false;
  if (botSerialized && participantSerialized === botSerialized) return true;

  const participantDigits = normalizeAccessPhone(participantSerialized.split('@')[0] || '');
  if (!participantDigits || !botDigits) return false;
  return participantDigits === botDigits || participantDigits.endsWith(botDigits) || botDigits.endsWith(participantDigits);
}

function normalizeMembershipRequester(value) {
  const serialized = extractSerializedWid(value);
  if (serialized) return serialized;
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.includes('@')) return raw;
  const digits = raw.replace(/\D/g, '');
  return digits ? `${digits}@c.us` : raw;
}

function normalizeConversationSender(entry) {
  const senderNumber = normalizeAccessPhone(entry?.senderNumber || '');
  if (senderNumber) return senderNumber;
  const senderJid = extractSerializedWid(entry?.senderJid || '');
  if (!senderJid) return '';
  return normalizeAccessPhone(String(senderJid).split('@')[0] || '');
}

function sanitizeNextPath(value) {
  const normalized = String(value || '').trim();
  if (!normalized.startsWith('/')) return '/';
  if (normalized.startsWith('//')) return '/';
  if (normalized.startsWith('/api/')) return '/';
  if (normalized === '/events') return '/';
  return normalized || '/';
}

function isProtectedDataRequest(pathname) {
  const path = String(pathname || '').trim();
  return path.startsWith('/api/') || path === '/events';
}

function panelActorFromRequest(req) {
  const username = String(req?.panelUser?.username || '').trim();
  return username ? `painel:${username}` : 'painel';
}

function trimInlineText(value, max = 160) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(1, max - 3))}...`;
}

function dedupeTextValues(values = []) {
  return Array.from(
    new Set(
      values
        .map((item) => String(item || '').trim())
        .filter(Boolean)
    )
  );
}

export function startWebPanel({ moderation = null, groupControl = null, inbox = null } = {}) {
  const app = express();
  const clients = new Set();
  const publicDir = resolve(process.cwd(), 'public');

  app.use(express.json({ limit: '1mb' }));

  app.get('/login.html', async (req, res) => {
    const nextPath = sanitizeNextPath(req.query.next || '/');
    const currentUser = await panelAuth.getAuthenticatedUser(req);
    if (currentUser) {
      res.redirect(nextPath);
      return;
    }

    res.sendFile(resolve(publicDir, 'login.html'));
  });

  app.post('/api/panel-auth/login', async (req, res) => {
    await botDatabase.ensureReady();

    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const nextPath = sanitizeNextPath(req.body?.next || '/');

    const result = await panelAuth.login(username, password);
    if (!result.ok || !result.user) {
      res.status(401).json({
        ok: false,
        message: result.message || 'Usuario ou senha invalidos.'
      });
      return;
    }

    panelAuth.setSessionCookie(res, result.sessionToken, result.expiresAt);
    res.json({
      ok: true,
      user: result.user,
      next: nextPath
    });
  });

  app.post('/api/panel-auth/logout', async (req, res) => {
    await panelAuth.logout(req, res);
    res.json({ ok: true });
  });

  // Endpoint pblico de health check (sem autenticacao)
  app.get('/health', async (req, res) => {
    await settingsStore.ensureReady();
    const runtime = settingsStore.get();
    const mem = process.memoryUsage();
    res.json({
      ok: true,
      now: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      pid: process.pid,
      memory: {
        rssKb: Math.round(mem.rss / 1024),
        heapUsedKb: Math.round(mem.heapUsed / 1024),
        heapTotalKb: Math.round(mem.heapTotal / 1024)
      },
      codexBin: config.codexBin,
      copilotBin: config.copilotBin,
      activeProvider: runtime.aiProvider || 'codex',
      providers: detectProviders(runtime),
      codexCircuit: getCodexCircuitStatus(),
      settingsFile: config.settingsFile,
      mediaIndexFile: config.mediaIndexFile
    });
  });

  app.use(async (req, res, next) => {
    if (req.path === '/favicon.ico') {
      res.status(204).end();
      return;
    }

    const user = await panelAuth.getAuthenticatedUser(req);
    if (!user) {
      if (isProtectedDataRequest(req.path)) {
        res.status(401).json({
          ok: false,
          reason: 'unauthorized',
          message: 'Autenticacao necessaria.'
        });
        return;
      }

      const nextPath = encodeURIComponent(sanitizeNextPath(req.originalUrl || '/'));
      res.redirect(`/login.html?next=${nextPath}`);
      return;
    }

    req.panelUser = user;
    req.panelSessionToken = panelAuth.getSessionToken(req);
    next();
  });

  app.get('/', (req, res) => {
    res.sendFile(resolve(publicDir, 'index.html'));
  });

  app.get('/processos.html', (req, res) => {
    res.sendFile(resolve(publicDir, 'processos.html'));
  });

  app.get('/usuarios.html', (req, res) => {
    res.sendFile(resolve(publicDir, 'usuarios.html'));
  });

  app.get('/multi-grupos.html', (req, res) => {
    res.sendFile(resolve(publicDir, 'multi-grupos.html'));
  });

  app.get('/bot-config-menu.html', (req, res) => {
    res.sendFile(resolve(publicDir, 'bot-config-menu.html'));
  });

  app.use(express.static(publicDir, { index: false }));

  app.get('/api/panel-auth/me', async (req, res) => {
    res.json({
      ok: true,
      user: req.panelUser
    });
  });

  app.get('/api/panel-users', async (req, res) => {
    await botDatabase.ensureReady();
    const users = await botDatabase.listPanelUsers();
    res.json({
      ok: true,
      users,
      currentUserId: Number(req.panelUser?.id || 0)
    });
  });

  app.post('/api/panel-users', async (req, res) => {
    await botDatabase.ensureReady();

    const result = await botDatabase.createPanelUser(req.body?.username, req.body?.password);
    res.status(result.ok ? 201 : 400).json(result);
  });

  app.put('/api/panel-users/:id/password', async (req, res) => {
    await botDatabase.ensureReady();

    const result = await botDatabase.updatePanelUserPassword(req.params.id, req.body?.password);
    if (result.ok && result.user) {
      panelAuth.invalidateUserSessions(result.user.id, {
        exceptToken: Number(result.user.id) === Number(req.panelUser?.id || 0) ? req.panelSessionToken : ''
      });
    }

    res.status(result.ok ? 200 : 400).json({
      ...result,
      passwordChangedCurrentUser: Boolean(
        result.ok && result.user && Number(result.user.id) === Number(req.panelUser?.id || 0)
      )
    });
  });

  app.delete('/api/panel-users/:id', async (req, res) => {
    await botDatabase.ensureReady();

    const targetId = Number.parseInt(String(req.params.id || ''), 10);
    const deletedSelf = Number.isFinite(targetId) && targetId === Number(req.panelUser?.id || 0);
    const result = await botDatabase.deletePanelUser(targetId);

    if (result.ok && result.removedUser) {
      panelAuth.invalidateUserSessions(result.removedUser.id);
      if (deletedSelf) {
        panelAuth.clearSessionCookie(res);
      }
    }

    res.status(result.ok ? 200 : 400).json({
      ...result,
      deletedSelf
    });
  });

  function getProviderModelFieldValue(providerId, slot, runtime = {}) {
    if (providerId === 'copilot') {
      if (slot === 'primary') return String(runtime.copilotModel || config.copilotModel || '').trim();
      if (slot === 'full') {
        return String(runtime.copilotFullModel || runtime.copilotModel || config.copilotFullModel || config.copilotModel || '').trim();
      }
      return String(runtime.copilotFallbackModel || config.copilotFallbackModel || '').trim();
    }

    if (slot === 'primary') return String(runtime.codexModel || config.codexModel || '').trim();
    return String(runtime.codexFallbackModel || config.codexFallbackModel || '').trim();
  }

  function describeProbeResult(probe, installed) {
    if (!installed) {
      return {
        status: 'missing',
        statusLabel: 'binario ausente',
        availableNow: false,
        message: 'Binario nao encontrado.',
        testedAt: ''
      };
    }

    if (!probe) {
      return {
        status: 'unknown',
        statusLabel: 'nao testado agora',
        availableNow: null,
        message: 'Sem verificacao recente.',
        testedAt: ''
      };
    }

    if (probe.ok) {
      return {
        status: 'available',
        statusLabel: 'disponivel agora',
        availableNow: true,
        message: trimInlineText(probe.output || probe.message || 'Teste concluido com sucesso.', 120),
        testedAt: probe.testedAt || ''
      };
    }

    return {
      status: 'unavailable',
      statusLabel: 'indisponivel no momento',
      availableNow: false,
      message: trimInlineText(probe.message || 'Falha no teste.', 120),
      testedAt: probe.testedAt || ''
    };
  }

  function buildAiProbeTargets(runtime = {}) {
    return [
      {
        providerId: 'copilot',
        mode: 'normal',
        fieldKey: 'copilotModel',
        model: getProviderModelFieldValue('copilot', 'primary', runtime)
      },
      {
        providerId: 'copilot',
        mode: 'full',
        fieldKey: 'copilotFullModel',
        model: getProviderModelFieldValue('copilot', 'full', runtime)
      },
      {
        providerId: 'copilot',
        mode: 'normal',
        fieldKey: 'copilotFallbackModel',
        model: getProviderModelFieldValue('copilot', 'fallback', runtime)
      },
      {
        providerId: 'codex',
        mode: 'normal',
        fieldKey: 'codexModel',
        model: getProviderModelFieldValue('codex', 'primary', runtime)
      },
      {
        providerId: 'codex',
        mode: 'normal',
        fieldKey: 'codexFallbackModel',
        model: getProviderModelFieldValue('codex', 'fallback', runtime)
      }
    ]
      .filter((target) => target.model)
      .map((target) => ({
        ...target,
        cacheKey: `${target.providerId}:${target.mode}:${target.model}`
      }));
  }

  function detectProviders(runtime = {}, probeData = null) {
    const providers = [];
    const activeProvider = String(runtime.aiProvider || 'codex').trim().toLowerCase() || 'codex';

    const codexBin = config.codexBin;
    const codexInstalled = Boolean(codexBin && existsSync(codexBin));
    const codexProbe = probeData?.providerStates?.codex || describeProbeResult(null, codexInstalled);
    providers.push({
      id: 'codex',
      name: 'OpenAI Codex CLI',
      bin: codexBin,
      installed: codexInstalled,
      source: 'VS Code Extension (openai.chatgpt)',
      active: activeProvider === 'codex',
      status: codexProbe.status,
      statusLabel: codexProbe.statusLabel,
      statusMessage: codexProbe.message,
      availableNow: codexProbe.availableNow,
      testedAt: codexProbe.testedAt,
      currentModel: getProviderModelFieldValue('codex', 'primary', runtime),
      fallbackModel: getProviderModelFieldValue('codex', 'fallback', runtime)
    });

    const copilotBin = config.copilotBin;
    const copilotInstalled = Boolean(copilotBin && existsSync(copilotBin));
    const copilotProbe = probeData?.providerStates?.copilot || describeProbeResult(null, copilotInstalled);
    providers.push({
      id: 'copilot',
      name: 'GitHub Copilot CLI',
      bin: copilotBin,
      installed: copilotInstalled,
      source: 'VS Code Extension (github.copilot-chat) + npm @github/copilot',
      active: activeProvider === 'copilot',
      status: copilotProbe.status,
      statusLabel: copilotProbe.statusLabel,
      statusMessage: copilotProbe.message,
      availableNow: copilotProbe.availableNow,
      testedAt: copilotProbe.testedAt,
      currentModel: getProviderModelFieldValue('copilot', 'primary', runtime),
      fullModel: getProviderModelFieldValue('copilot', 'full', runtime),
      fallbackModel: getProviderModelFieldValue('copilot', 'fallback', runtime)
    });

    return providers;
  }

  function runProviderTest(providerId, options = {}) {
    return new Promise((resolve, reject) => {
      const testPrompt = 'Responda apenas: teste ok';
      const runtime = options.runtime && typeof options.runtime === 'object' ? options.runtime : {};
      const requestedMode = String(options.mode || '').trim().toLowerCase();
      const mode = requestedMode === 'full' ? 'full' : 'normal';
      const modelOverride = normalizeModelAlias(providerId, mode, options.model, runtime);
      let args;
      let bin;
      let effectiveModel = '';

      if (providerId === 'copilot') {
        bin = config.copilotBin;
        args = ['-p', testPrompt, '-s', '--no-color', '--no-ask-user'];
        if (mode === 'full') {
          effectiveModel = modelOverride || runtime.copilotFullModel || runtime.copilotModel || config.copilotModel || '';
        } else {
          effectiveModel = modelOverride || runtime.copilotModel || config.copilotModel || '';
        }
        if (effectiveModel) {
          args.push('--model', effectiveModel);
        }
      } else {
        bin = config.codexBin;
        args = ['exec', '-', '--skip-git-repo-check', '--color', 'never'];
        effectiveModel = modelOverride || runtime.codexModel || config.codexModel || '';
        if (effectiveModel) {
          args.push('-m', effectiveModel);
        }
        if (config.codexEphemeral) {
          args.push('--ephemeral');
        }
      }

      if (!bin || !existsSync(bin)) {
        return reject(new Error(`Binario nao encontrado: ${bin || '(vazio)'}`));
      }

      const startedAt = Date.now();
      const child = spawn(bin, args, {
        cwd: config.codexWorkdir,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, 20000);

      child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
      child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (killed) return reject(new Error('Timeout de 20s excedido'));
        const elapsedMs = Date.now() - startedAt;
        const trimmedStdout = stdout.trim();
        const trimmedStderr = stderr.trim();
        const output = trimmedStdout || trimmedStderr;

        const copilotFatalStderr =
          providerId === 'copilot' &&
          !trimmedStdout &&
          /\b(402|no quota|not available|usage:|error:|failed|forbidden|unauthorized)\b/i.test(trimmedStderr);

        if (copilotFatalStderr) {
          return reject(new Error(trimmedStderr.slice(0, 300) || 'Falha no Copilot'));
        }

        if (code === 0 && output) {
          resolve({
            output: output.slice(0, 500),
            elapsedMs,
            exitCode: code,
            model: effectiveModel || '',
            mode
          });
        } else {
          reject(new Error(`Exit ${code}: ${(trimmedStderr || trimmedStdout || 'sem saida').slice(0, 300)}`));
        }
      });

      if (providerId !== 'copilot') {
        child.stdin.write(testPrompt);
      }
      child.stdin.end();
    });
  }

  async function getAiProviderProbeData(runtime = {}, { forceRefresh = false } = {}) {
    const now = Date.now();
    const hasFreshCache =
      aiProviderProbeCache && Number.isFinite(aiProviderProbeCache.generatedAt)
        ? (now - aiProviderProbeCache.generatedAt) <= AI_PROVIDER_PROBE_CACHE_MAX_AGE_MS
        : false;

    if (!forceRefresh && hasFreshCache) {
      return aiProviderProbeCache;
    }

    const detectedProviders = detectProviders(runtime, null);
    const installedByProvider = new Map(detectedProviders.map((provider) => [provider.id, Boolean(provider.installed)]));
    const targets = buildAiProbeTargets(runtime);
    const uniqueTargets = [];
    const seenKeys = new Set();

    for (const target of targets) {
      if (seenKeys.has(target.cacheKey)) continue;
      seenKeys.add(target.cacheKey);
      uniqueTargets.push(target);
    }

    const modelEntries = await Promise.all(uniqueTargets.map(async (target) => {
      const installed = Boolean(installedByProvider.get(target.providerId));
      if (!installed) {
        return [
          target.cacheKey,
          {
            ...target,
            ok: false,
            installed: false,
            message: 'Binario nao encontrado.',
            testedAt: new Date().toISOString()
          }
        ];
      }

      try {
        const result = await runProviderTest(target.providerId, {
          runtime,
          model: target.model,
          mode: target.mode
        });
        return [
          target.cacheKey,
          {
            ...target,
            ok: true,
            installed: true,
            output: result.output || '',
            elapsedMs: result.elapsedMs || 0,
            exitCode: result.exitCode,
            model: result.model || target.model,
            testedAt: new Date().toISOString()
          }
        ];
      } catch (error) {
        return [
          target.cacheKey,
          {
            ...target,
            ok: false,
            installed: true,
            message: String(error?.message || error),
            testedAt: new Date().toISOString()
          }
        ];
      }
    }));

    const models = Object.fromEntries(modelEntries);
    const providerStates = {};

    for (const provider of detectedProviders) {
      const primaryFieldKey = provider.id === 'copilot' ? 'copilotModel' : 'codexModel';
      const probeTarget = uniqueTargets.find((target) => target.providerId === provider.id && target.fieldKey === primaryFieldKey);
      const probe = probeTarget ? models[probeTarget.cacheKey] : null;
      providerStates[provider.id] = describeProbeResult(probe, provider.installed);
    }

    aiProviderProbeCache = {
      generatedAt: now,
      generatedAtIso: new Date(now).toISOString(),
      models,
      providerStates
    };

    return aiProviderProbeCache;
  }

  function buildModelFieldOptions({ providerId, mode, fieldKey, selectedValue, providersById, probeData }) {
    const provider = providersById.get(providerId) || { installed: false };
    const candidateModels = dedupeTextValues([
      selectedValue,
      ...(AI_PROVIDER_MODEL_MATRIX[providerId] || [])
    ]);

    const options = candidateModels.map((modelValue) => {
      const exactProbe = probeData?.models?.[`${providerId}:${mode}:${modelValue}`];
      const fallbackProbe = mode !== 'normal' ? probeData?.models?.[`${providerId}:normal:${modelValue}`] : null;
      const probe = exactProbe || fallbackProbe || null;
      const probeDescription = describeProbeResult(probe, provider.installed);
      return {
        value: modelValue,
        label: modelValue,
        selected: modelValue === selectedValue,
        status: probeDescription.status,
        statusLabel: probeDescription.statusLabel,
        detail: probeDescription.message
      };
    });

    return {
      fieldKey,
      providerId,
      mode,
      selectedValue,
      installed: Boolean(provider.installed),
      options
    };
  }

  function buildAiProviderOptions(runtime = {}, providers = [], probeData = null) {
    const providersById = new Map(providers.map((provider) => [provider.id, provider]));

    return {
      providerOptions: providers.map((provider) => ({
        value: provider.id,
        label: `${provider.name} | ${provider.active ? 'ativo' : 'standby'} | ${provider.statusLabel}`,
        active: provider.active,
        disabled: !provider.installed,
        status: provider.status,
        statusLabel: provider.statusLabel,
        availableNow: provider.availableNow
      })),
      reasoningEfforts: AI_REASONING_EFFORT_OPTIONS.map((value) => ({
        value,
        label: value,
        selected: value === String(runtime.codexReasoningEffort || 'medium').trim().toLowerCase()
      })),
      modelFields: {
        copilotModel: buildModelFieldOptions({
          providerId: 'copilot',
          mode: 'normal',
          fieldKey: 'copilotModel',
          selectedValue: getProviderModelFieldValue('copilot', 'primary', runtime),
          providersById,
          probeData
        }),
        copilotFullModel: buildModelFieldOptions({
          providerId: 'copilot',
          mode: 'full',
          fieldKey: 'copilotFullModel',
          selectedValue: getProviderModelFieldValue('copilot', 'full', runtime),
          providersById,
          probeData
        }),
        copilotFallbackModel: buildModelFieldOptions({
          providerId: 'copilot',
          mode: 'normal',
          fieldKey: 'copilotFallbackModel',
          selectedValue: getProviderModelFieldValue('copilot', 'fallback', runtime),
          providersById,
          probeData
        }),
        codexModel: buildModelFieldOptions({
          providerId: 'codex',
          mode: 'normal',
          fieldKey: 'codexModel',
          selectedValue: getProviderModelFieldValue('codex', 'primary', runtime),
          providersById,
          probeData
        }),
        codexFallbackModel: buildModelFieldOptions({
          providerId: 'codex',
          mode: 'normal',
          fieldKey: 'codexFallbackModel',
          selectedValue: getProviderModelFieldValue('codex', 'fallback', runtime),
          providersById,
          probeData
        })
      }
    };
  }

  app.get('/api/ai-providers', async (req, res) => {
    await settingsStore.ensureReady();
    const runtime = settingsStore.get();
    const wantsProbe = ['1', 'true', 'yes', 'sim'].includes(String(req.query.probe || '').trim().toLowerCase());
    const forceRefresh = ['1', 'true', 'yes', 'sim'].includes(String(req.query.refresh || '').trim().toLowerCase());
    const probeData = wantsProbe
      ? await getAiProviderProbeData(runtime, { forceRefresh })
      : aiProviderProbeCache;
    const providers = detectProviders(runtime, probeData);
    const options = buildAiProviderOptions(runtime, providers, probeData);
    const probeGeneratedAt = probeData?.generatedAt || 0;
    const probeAgeMs = probeGeneratedAt ? Math.max(0, Date.now() - probeGeneratedAt) : null;
    res.json({
      ok: true,
      activeProvider: runtime.aiProvider || 'codex',
      providers,
      options,
      probe: {
        generatedAt: probeData?.generatedAtIso || '',
        ageMs: probeAgeMs,
        stale: Number.isFinite(probeAgeMs) ? probeAgeMs > AI_PROVIDER_PROBE_CACHE_MAX_AGE_MS : false,
        hasData: Boolean(probeData?.generatedAtIso),
        maxAgeMs: AI_PROVIDER_PROBE_CACHE_MAX_AGE_MS,
        requested: wantsProbe
      }
    });
  });

  app.post('/api/ai-providers/test', async (req, res) => {
    const providerId = String(req.body?.provider || '').trim().toLowerCase();
    if (!['codex', 'copilot'].includes(providerId)) {
      return res.status(400).json({ ok: false, message: 'Provedor invalido. Use: codex ou copilot' });
    }
    try {
      await settingsStore.ensureReady();
      const runtime = settingsStore.get();
      const result = await runProviderTest(providerId, {
        runtime,
        model: req.body?.model,
        mode: req.body?.mode
      });
      res.json({ ok: true, provider: providerId, ...result });
    } catch (error) {
      res.json({ ok: false, provider: providerId, message: String(error?.message || error) });
    }
  });

  app.post('/api/ai-providers/activate', async (req, res) => {
    const providerId = String(req.body?.provider || '').trim().toLowerCase();
    if (!['codex', 'copilot'].includes(providerId)) {
      return res.status(400).json({ ok: false, message: 'Provedor invalido.' });
    }
    await settingsStore.ensureReady();
    const result = await settingsStore.update(
      { aiProvider: providerId },
      { actor: 'painel-web', reason: 'troca_provedor_ia' }
    );
    res.json({ ok: true, activeProvider: providerId, auditId: result.auditId });
  });

  app.post('/api/send-media', async (req, res) => {
    const filePath = String(req.body?.filePath || '').trim();
    const caption = String(req.body?.caption || '').trim();
    const targetGroupId = String(req.body?.groupId || '').trim();

    if (!filePath) {
      res.status(400).json({ ok: false, message: 'filePath obrigatorio.' });
      return;
    }

    const context = await resolveGroupContext();
    if (!context.ok) {
      res.status(context.status || 400).json(context);
      return;
    }

    const { client } = context;
    const groupId = targetGroupId || context.groupId;

    try {
      const { MessageMedia } = await import('whatsapp-web.js');
      const media = MessageMedia.fromFilePath(filePath);
      await client.sendMessage(groupId, media, { caption });
      res.json({ ok: true, message: 'Midia enviada com sucesso.', groupId });
    } catch (error) {
      res.status(500).json({ ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/send-message', async (req, res) => {
    const targetGroupId = String(req.body?.groupId || '').trim();
    const text = String(req.body?.text || '').trim();
    if (!text) {
      res.status(400).json({ ok: false, message: 'text e obrigatorio.' });
      return;
    }
    const context = await resolveGroupContext();
    if (!context.ok) {
      res.status(context.status || 400).json(context);
      return;
    }
    const { client } = context;
    const groupId = targetGroupId || context.groupId;
    try {
      await client.sendMessage(groupId, text);
      res.json({ ok: true, groupId });
    } catch (error) {
      res.status(500).json({ ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/full-jobs/start', async (req, res) => {
    const text = String(req.body?.text || '').trim();
    const targetGroupId = String(req.body?.groupId || '').trim();
    const senderNumber = String(req.body?.senderNumber || 'panel-admin').trim();
    if (!text) {
      res.status(400).json({ ok: false, message: 'text obrigatorio.' });
      return;
    }
    const context = await resolveGroupContext();
    if (!context.ok) {
      res.status(context.status || 400).json(context);
      return;
    }
    const groupId = targetGroupId || context.groupId;
    try {
      const { startFullAutoJobDirect } = await import('./localActions.js');
      const jobContext = { client: context.client, groupId, senderNumber, notificationGroupId: config.notificationGroupJid || groupId };
      const result = await startFullAutoJobDirect(text, jobContext);
      res.json({ ok: true, result });
      // Executa o afterSend em background (Codex real)
      if (result?.afterSend && typeof result.afterSend === 'function') {
        setImmediate(() => result.afterSend().catch((e) => console.error('[webPanel] afterSend error:', e)));
      }
    } catch (error) {
      res.status(500).json({ ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/health', async (req, res) => {
    // Mantido por compatibilidade — redireciona para o endpoint pblico acima
    await settingsStore.ensureReady();
    const runtime = settingsStore.get();
    const mem = process.memoryUsage();
    res.json({
      ok: true,
      now: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      pid: process.pid,
      memory: {
        rssKb: Math.round(mem.rss / 1024),
        heapUsedKb: Math.round(mem.heapUsed / 1024),
        heapTotalKb: Math.round(mem.heapTotal / 1024)
      },
      codexBin: config.codexBin,
      copilotBin: config.copilotBin,
      activeProvider: runtime.aiProvider || 'codex',
      providers: detectProviders(runtime),
      codexCircuit: getCodexCircuitStatus(),
      settingsFile: config.settingsFile,
      mediaIndexFile: config.mediaIndexFile
    });
  });

  app.get('/api/runtime', async (req, res) => {
    await settingsStore.ensureReady();

    res.json({
      state: getRuntimeState(),
      logs: getRecentLogs(),
      settings: settingsStore.get()
    });
  });

  app.get('/api/full-jobs', async (req, res) => {
    await settingsStore.ensureReady();
    const limit = parseIntSafe(req.query.limit, 80, 1, 200);
    const snapshot = getFullAutoJobsSnapshot({ limit });

    // Merge DB history for older jobs not in memory
    try {
      await botDatabase.ensureReady();
      const daysBack = parseIntSafe(req.query.days, 30, 1, 90);
      const dbJobs = botDatabase.listFullJobsByAge({ limit: 500, daysBack });
      const inMemIds = new Set(snapshot.items.map((j) => j.id));
      const historyOnly = dbJobs.filter((j) => !inMemIds.has(j.id));
      if (historyOnly.length) {
        snapshot.items = [...snapshot.items, ...historyOnly]
          .sort((a, b) => Number(b.startedAt || 0) - Number(a.startedAt || 0))
          .slice(0, 500);
        snapshot.total = snapshot.items.length;
      }
    } catch {
      // fallback to in-memory only
    }

    res.json(snapshot);
  });

  app.delete('/api/full-jobs/clear', async (req, res) => {
    try {
      await botDatabase.ensureReady();
      const daysToKeep = parseIntSafe(req.query.keepDays, 0, 0, 365);
      let deleted = 0;
      if (daysToKeep > 0) {
        const beforeMs = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
        deleted = botDatabase.clearFullJobs({ beforeMs });
      } else {
        deleted = botDatabase.clearFullJobs();
      }
      res.json({ ok: true, deleted });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  app.get('/api/full-jobs/history', async (req, res) => {
    try {
      await botDatabase.ensureReady();
      const limit = parseIntSafe(req.query.limit, 200, 1, 1000);
      const daysBack = parseIntSafe(req.query.days, 30, 1, 90);
      const jobs = botDatabase.listFullJobsByAge({ limit, daysBack });
      res.json({ ok: true, total: jobs.length, items: jobs });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  app.get('/api/full-jobs/:id/export', async (req, res) => {
    try {
      const jobId = String(req.params.id || '').trim();
      if (!jobId) return res.status(400).json({ ok: false, error: 'id obrigatorio' });

      // Check in-memory first
      const inMemJobs = listFullAutoJobs({ limit: 200 });
      let job = inMemJobs.find((j) => j.id === jobId) || null;

      if (!job) {
        await botDatabase.ensureReady();
        job = botDatabase.getFullJobById(jobId);
      }

      if (!job) return res.status(404).json({ ok: false, error: 'Job nao encontrado' });

      const lines = [
        `=== FULL Job #${job.id} ===`,
        `Remetente: ${job.senderNumber}`,
        `Grupo: ${job.groupId}`,
        `Status: ${job.status}`,
        `Início: ${new Date(job.startedAt).toLocaleString('pt-BR')}`,
        job.finishedAt ? `Conclusão: ${new Date(job.finishedAt).toLocaleString('pt-BR')}` : '',
        ``,
        `=== Pedido ===`,
        job.request,
        ``,
        `=== Log de Execução ===`,
        ...(Array.isArray(job.logLines) ? job.logLines : []),
        ``
      ];

      if (job.summary) {
        lines.push(`=== Resposta Final ===`);
        lines.push(job.summary);
        lines.push('');
      }
      if (job.error) {
        lines.push(`=== Erro ===`);
        lines.push(job.error);
        lines.push('');
      }

      const text = lines.filter((l) => l !== null).join('\n');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="full-job-${job.id}.txt"`);
      res.send(text);
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  app.get('/api/settings', async (req, res) => {
    await settingsStore.ensureReady();
    res.json({ ok: true, settings: settingsStore.get() });
  });

  app.put('/api/settings', async (req, res) => {
    await settingsStore.ensureReady();

    const baseRuntime = settingsStore.get();
    const patchRaw = req.body && typeof req.body === 'object' ? req.body : {};
    const patch = normalizeModelPatch(patchRaw, baseRuntime);
    const actor = panelActorFromRequest(req);
    const reason = String(req.body?.reason || 'panel_update').trim();

    const result = await settingsStore.update(patch, {
      actor,
      source: 'web_panel',
      reason
    });

    res.json({
      ok: true,
      changed: result.changed,
      auditId: result.auditId,
      changedKeys: result.changedKeys,
      settings: result.settings
    });
  });

  app.get('/api/settings/audit', async (req, res) => {
    await settingsStore.ensureReady();
    const limit = parseIntSafe(req.query.limit, 30, 1, 300);
    const entries = await settingsStore.listAudit(limit);
    res.json({ ok: true, total: entries.length, items: entries });
  });

  app.post('/api/settings/rollback/:id', async (req, res) => {
    await settingsStore.ensureReady();
    const auditId = String(req.params.id || '').trim();
    const actor = panelActorFromRequest(req);

    const result = await settingsStore.rollback(auditId, {
      actor,
      source: 'web_panel_rollback'
    });

    res.status(result.ok ? 200 : 400).json(result);
  });

  app.get('/api/media', async (req, res) => {
    await mediaStore.ensureReady();

    const limit = parseIntSafe(req.query.limit, 50, 1, 500);
    const offset = parseIntSafe(req.query.offset, 0, 0, 100000);
    const includeDeleted = ['1', 'true', 'yes'].includes(String(req.query.includeDeleted || '').toLowerCase());

    const result = mediaStore.list({
      groupId: req.query.groupId || '',
      sender: req.query.sender || '',
      mediaType: req.query.mediaType || '',
      query: req.query.query || '',
      includeDeleted,
      limit,
      offset
    });

    res.json({ ok: true, ...result });
  });

  app.get('/api/media/:id', async (req, res) => {
    await mediaStore.ensureReady();
    const item = mediaStore.getById(req.params.id);
    if (!item) {
      res.status(404).json({ ok: false, message: 'Arquivo nao encontrado.' });
      return;
    }

    res.json({ ok: true, item });
  });

  app.get('/api/media/:id/download', async (req, res) => {
    const result = await mediaStore.resolveDownloadPath(req.params.id, {
      password: String(req.query.password || '')
    });
    if (!result.ok) {
      res.status(404).json(result);
      return;
    }

    const fileName = result.item?.fileName || 'arquivo';
    res.download(result.filePath, fileName);
  });

  app.delete('/api/media/:id', async (req, res) => {
    const result = await mediaStore.deleteById(req.params.id, {
      password: String(req.query.password || '')
    });
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.post('/api/media/:id/protect', async (req, res) => {
    const value = Boolean(req.body?.protected);
    const result = await mediaStore.markProtected(req.params.id, value, {
      password: String(req.body?.password || ''),
      clearPassword: parseBoolean(req.body?.clearPassword, false)
    });
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.post('/api/media/cleanup', async (req, res) => {
    await settingsStore.ensureReady();
    const days = parseIntSafe(req.body?.days, settingsStore.get().mediaRetentionDays, 1, 3650);
    const result = await mediaStore.cleanup(days);
    res.json(result);
  });

  app.get('/api/moderation', async (req, res) => {
    if (!moderation) {
      res.status(503).json({ ok: false, message: 'Moderacao indisponivel.' });
      return;
    }

    await moderation.ensureReady();
    const groupId = String(req.query.groupId || getRuntimeState().authorizedGroupJid || '').trim();
    res.json({
      ok: true,
      moderation: moderation.snapshot(groupId)
    });
  });

  app.put('/api/moderation', async (req, res) => {
    if (!moderation) {
      res.status(503).json({ ok: false, message: 'Moderacao indisponivel.' });
      return;
    }

    await moderation.ensureReady();
    const enabled = parseBoolean(req.body?.enabled, moderation.isEnabled());
    const maxWarnings = parseIntSafe(req.body?.maxWarnings, moderation.maxWarnings(), 1, 20);

    await moderation.setEnabled(enabled);
    await moderation.setMaxWarnings(maxWarnings);

    res.json({
      ok: true,
      moderation: moderation.snapshot(String(req.body?.groupId || getRuntimeState().authorizedGroupJid || '').trim())
    });
  });

  app.post('/api/moderation/keywords', async (req, res) => {
    if (!moderation) {
      res.status(503).json({ ok: false, message: 'Moderacao indisponivel.' });
      return;
    }

    await moderation.ensureReady();
    const keyword = String(req.body?.keyword || '').trim();
    const result = await moderation.addKeyword(keyword);
    res.status(result.added ? 200 : 400).json({
      ok: result.added,
      ...result,
      moderation: moderation.snapshot(String(req.body?.groupId || getRuntimeState().authorizedGroupJid || '').trim())
    });
  });

  app.delete('/api/moderation/keywords/:keyword', async (req, res) => {
    if (!moderation) {
      res.status(503).json({ ok: false, message: 'Moderacao indisponivel.' });
      return;
    }

    await moderation.ensureReady();
    const keyword = decodeURIComponent(String(req.params.keyword || '')).trim();
    const result = await moderation.removeKeyword(keyword);
    res.status(result.removed ? 200 : 400).json({
      ok: result.removed,
      ...result,
      moderation: moderation.snapshot(String(req.query.groupId || getRuntimeState().authorizedGroupJid || '').trim())
    });
  });

  app.post('/api/moderation/keywords/clear', async (req, res) => {
    if (!moderation) {
      res.status(503).json({ ok: false, message: 'Moderacao indisponivel.' });
      return;
    }

    await moderation.ensureReady();
    const removed = await moderation.clearKeywords();
    res.json({
      ok: true,
      removed,
      moderation: moderation.snapshot(String(req.body?.groupId || getRuntimeState().authorizedGroupJid || '').trim())
    });
  });

  app.post('/api/moderation/warnings/reset', async (req, res) => {
    if (!moderation) {
      res.status(503).json({ ok: false, message: 'Moderacao indisponivel.' });
      return;
    }

    await moderation.ensureReady();
    const groupId = String(req.body?.groupId || getRuntimeState().authorizedGroupJid || '').trim();
    if (!groupId) {
      res.status(400).json({ ok: false, message: 'groupId obrigatorio para resetar avisos.' });
      return;
    }

    const target = normalizeAccessPhone(req.body?.target || '');
    const removed = await moderation.resetWarnings(groupId, target ? `${target}@c.us` : '');
    res.json({
      ok: true,
      removed,
      moderation: moderation.snapshot(groupId)
    });
  });

  async function resolveGroupContext() {
    const client = groupControl?.getClient?.();
    const groupId = String(groupControl?.getGroupId?.() || getRuntimeState().authorizedGroupJid || '').trim();

    if (!client) {
      return { ok: false, status: 503, message: 'Cliente WhatsApp indisponivel no momento.' };
    }

    if (!groupId) {
      return { ok: false, status: 400, message: 'Grupo autorizado ainda nao definido.' };
    }

    let chat = null;
    try {
      chat = await client.getChatById(groupId);
    } catch (error) {
      return {
        ok: false,
        status: 500,
        message: `Falha ao abrir grupo autorizado: ${error instanceof Error ? error.message : String(error)}`
      };
    }

    if (!chat?.isGroup) {
      return { ok: false, status: 400, message: 'O chat autorizado atual nao e um grupo.' };
    }

    return { ok: true, client, groupId, chat };
  }

  function getPrimaryGroupId() {
    return normalizeAccessGroup(groupControl?.getGroupId?.() || getRuntimeState().authorizedGroupJid || '');
  }

  function buildResponseRoutingSnapshot() {
    const primaryGroupId = getPrimaryGroupId();
    const accessSnapshot = accessControl.snapshot(primaryGroupId);
    return {
      primaryGroupId,
      dynamicResponseGroups: accessSnapshot.dynamicResponseGroups,
      effectiveResponseGroups: accessSnapshot.effectiveResponseGroups,
      dynamicPrivate: accessSnapshot.dynamicPrivate,
      effectivePrivate: accessSnapshot.effectivePrivate,
      updatedAt: accessSnapshot.updatedAt
    };
  }

  async function buildResponseRoutingDiagnostics() {
    await accessControl.ensureReady();
    await settingsStore.ensureReady();

    const routing = buildResponseRoutingSnapshot();
    const runtime = getRuntimeState();
    const requireMention = Boolean(settingsStore.get().requireMention);
    const runtimeStatus = String(runtime.whatsappStatus || '').trim();
    const runtimeReady = runtimeStatus.toLowerCase().includes('pronto');
    const client = groupControl?.getClient?.();

    const chatById = new Map();
    const fromClientGroupIds = [];

    if (client && typeof client.getChats === 'function') {
      try {
        const chats = await client.getChats();
        for (const chat of Array.isArray(chats) ? chats : []) {
          if (!chat?.isGroup) continue;
          const groupId = normalizeAccessGroup(extractSerializedWid(chat?.id || chat));
          if (!groupId) continue;
          chatById.set(groupId, chat);
          fromClientGroupIds.push(groupId);
        }
      } catch {
        // fallback: usa somente ids de roteamento
      }
    }

    const routingSet = new Set(Array.isArray(routing.effectiveResponseGroups) ? routing.effectiveResponseGroups : []);
    const dynamicSet = new Set(Array.isArray(routing.dynamicResponseGroups) ? routing.dynamicResponseGroups : []);
    const knownGroupIds = new Set([...fromClientGroupIds, ...routingSet]);
    if (routing.primaryGroupId) knownGroupIds.add(routing.primaryGroupId);

    const botSerialized = extractSerializedWid(client?.info?.wid || client?.info?.me || '');
    const botDigits = normalizeWidDigits(botSerialized);
    const groups = [];

    for (const groupId of knownGroupIds) {
      let chat = chatById.get(groupId) || null;
      if (!chat && client && typeof client.getChatById === 'function') {
        try {
          chat = await client.getChatById(groupId);
        } catch {
          chat = null;
        }
      }

      const participants = Array.isArray(chat?.participants) ? chat.participants : [];
      const metadata = chat?.groupMetadata && typeof chat.groupMetadata === 'object' ? chat.groupMetadata : {};
      const botParticipant = participants.find((participant) => participantMatchesBot(participant, botSerialized, botDigits));
      const botIsAdmin = Boolean(botParticipant && isGroupParticipantAdmin(botParticipant));
      const messagesAdminsOnly = Boolean(metadata.announce);
      const infoAdminsOnly = Boolean(metadata.restrict);
      const addMembersAdminsOnly = /admin/i.test(String(metadata.memberAddMode || ''));
      const inRouting = routingSet.has(groupId);
      const isPrimary = Boolean(routing.primaryGroupId && groupId === routing.primaryGroupId);
      const isDynamic = dynamicSet.has(groupId);
      const canBotSpeak = !messagesAdminsOnly || botIsAdmin;
      const canRespondWhenMentioned = inRouting && runtimeReady && canBotSpeak;
      const canRespondWithoutMention = canRespondWhenMentioned && !requireMention;

      let responseReason = '';
      if (!inRouting) {
        responseReason = 'Grupo fora da lista de resposta.';
      } else if (!runtimeReady) {
        responseReason = 'WhatsApp ainda nao esta pronto.';
      } else if (!canBotSpeak) {
        responseReason = 'Grupo fechado para admins e o bot nao esta admin.';
      } else if (requireMention) {
        responseReason = 'Responde quando houver mencao ao bot.';
      } else {
        responseReason = 'Responde normalmente sem mencao.';
      }

      const subject = String(chat?.name || metadata.subject || '').trim();
      const adminsCount = participants.filter((participant) => isGroupParticipantAdmin(participant)).length;

      groups.push({
        groupId,
        subject,
        participantsCount: participants.length,
        adminsCount,
        flags: {
          isPrimary,
          inRouting,
          isDynamic,
          isKnownByClient: Boolean(chat),
          botIsAdmin,
          messagesAdminsOnly,
          infoAdminsOnly,
          addMembersAdminsOnly,
          requireMention,
          canBotSpeak,
          canRespondWhenMentioned,
          canRespondWithoutMention
        },
        responseReason
      });
    }

    groups.sort((a, b) => {
      const scoreA =
        (a.flags.isPrimary ? 100 : 0) + (a.flags.inRouting ? 40 : 0) + (a.flags.canRespondWhenMentioned ? 20 : 0);
      const scoreB =
        (b.flags.isPrimary ? 100 : 0) + (b.flags.inRouting ? 40 : 0) + (b.flags.canRespondWhenMentioned ? 20 : 0);
      if (scoreA !== scoreB) return scoreB - scoreA;
      return String(a.subject || a.groupId).localeCompare(String(b.subject || b.groupId), 'pt-BR');
    });

    return {
      runtimeStatus,
      runtimeReady,
      requireMention,
      routing,
      groups,
      counts: {
        totalKnownGroups: groups.length,
        groupsInRouting: groups.filter((item) => item.flags.inRouting).length,
        groupsRespondingWhenMentioned: groups.filter((item) => item.flags.canRespondWhenMentioned).length,
        groupsRespondingWithoutMention: groups.filter((item) => item.flags.canRespondWithoutMention).length
      },
      updatedAt: new Date().toISOString()
    };
  }

  function syncRuntimeRoutingState() {
    const primaryGroupId = getPrimaryGroupId();
    updateRuntimeState({
      responseGroupJids: accessControl.allResponseGroupIds(primaryGroupId),
      privateAllowedNumbers: accessControl.allPrivateNumbers()
    });
  }

  async function buildGroupSnapshot({ includeInvite = false, includeRequests = false } = {}) {
    const context = await resolveGroupContext();
    if (!context.ok) return context;

    const { client, groupId, chat } = context;
    const participants = Array.isArray(chat.participants) ? chat.participants : [];
    const admins = participants
      .filter((participant) => isGroupParticipantAdmin(participant))
      .map((participant) => extractSerializedWid(participant?.id || participant))
      .filter(Boolean);
    const metadata = chat.groupMetadata && typeof chat.groupMetadata === 'object' ? chat.groupMetadata : {};

    let inviteCode = '';
    if (includeInvite && typeof chat.getInviteCode === 'function') {
      try {
        inviteCode = String((await chat.getInviteCode()) || '').trim();
      } catch {
        inviteCode = '';
      }
    }

    let requests = [];
    if (includeRequests && typeof client.getGroupMembershipRequests === 'function') {
      try {
        const rawRequests = await client.getGroupMembershipRequests(groupId);
        requests = Array.isArray(rawRequests)
          ? rawRequests.map((item) => {
              const requester =
                normalizeMembershipRequester(item?.id || item?.requester || item?.requesterId || item?.author || item?.participant) ||
                '';
              return {
                requester,
                createdAt: Number(item?.timestamp || item?.createdAt || 0) || null
              };
            })
          : [];
      } catch {
        requests = [];
      }
    }

    return {
      ok: true,
      group: {
        groupId,
        subject: String(chat.name || metadata.subject || '').trim(),
        description: String(chat.description || metadata.desc || '').trim(),
        participantsCount: participants.length,
        adminsCount: admins.length,
        admins,
        messagesAdminsOnly: Boolean(metadata.announce),
        infoAdminsOnly: Boolean(metadata.restrict),
        addMembersAdminsOnly: /admin/i.test(String(metadata.memberAddMode || '')),
        inviteCode,
        inviteLink: inviteCode ? `https://chat.whatsapp.com/${inviteCode}` : '',
        membershipRequestsCount: requests.length,
        membershipRequests: requests
      }
    };
  }

  app.get('/api/group/control', async (req, res) => {
    const includeInvite = parseBoolean(req.query.includeInvite, false);
    const includeRequests = parseBoolean(req.query.includeRequests, false);
    const snapshot = await buildGroupSnapshot({ includeInvite, includeRequests });
    if (!snapshot.ok) {
      res.status(snapshot.status || 400).json(snapshot);
      return;
    }
    res.json(snapshot);
  });

  app.post('/api/group/control/action', async (req, res) => {
    const action = String(req.body?.action || '').trim().toLowerCase();
    const value = req.body?.value;
    const subject = String(req.body?.subject || '').trim();
    const hasDescriptionField = Boolean(
      req.body && Object.prototype.hasOwnProperty.call(req.body, 'description')
    );
    const description = hasDescriptionField ? String(req.body?.description ?? '').trim() : '';
    const requesterIds = Array.isArray(req.body?.requesterIds)
      ? req.body.requesterIds.map((item) => normalizeMembershipRequester(item)).filter(Boolean)
      : [];

    if (!action) {
      res.status(400).json({ ok: false, message: 'Acao obrigatoria.' });
      return;
    }

    const context = await resolveGroupContext();
    if (!context.ok) {
      res.status(context.status || 400).json(context);
      return;
    }

    const { client, groupId, chat } = context;
    let detail = '';

    try {
      if (action === 'set_subject') {
        if (!subject) throw new Error('Informe o novo nome do grupo.');
        if (typeof chat.setSubject !== 'function') throw new Error('Metodo setSubject indisponivel nesta versao.');
        await chat.setSubject(subject);
        detail = 'Nome do grupo atualizado.';
      } else if (action === 'set_description') {
        if (!hasDescriptionField) throw new Error('Informe a nova descricao do grupo.');
        if (typeof chat.setDescription !== 'function') throw new Error('Metodo setDescription indisponivel nesta versao.');
        if (!description) {
          detail = 'Descricao vazia recebida. Nenhuma alteracao aplicada (WhatsApp exige texto para atualizar).';
        } else {
          await chat.setDescription(description);
          detail = 'Descricao do grupo atualizada.';
        }
      } else if (action === 'set_messages_admins_only') {
        if (typeof chat.setMessagesAdminsOnly !== 'function') throw new Error('Metodo setMessagesAdminsOnly indisponivel.');
        const enabled = parseBoolean(value, true);
        await chat.setMessagesAdminsOnly(enabled);
        detail = enabled ? 'Grupo fechado: somente admins enviam mensagens.' : 'Grupo aberto: todos podem enviar mensagens.';
      } else if (action === 'set_info_admins_only') {
        if (typeof chat.setInfoAdminsOnly !== 'function') throw new Error('Metodo setInfoAdminsOnly indisponivel.');
        const enabled = parseBoolean(value, true);
        await chat.setInfoAdminsOnly(enabled);
        detail = enabled ? 'Edicao de informacoes restrita a admins.' : 'Edicao de informacoes liberada para participantes.';
      } else if (action === 'set_add_members_admins_only') {
        if (typeof chat.setAddMembersAdminsOnly !== 'function') throw new Error('Metodo setAddMembersAdminsOnly indisponivel.');
        const enabled = parseBoolean(value, true);
        await chat.setAddMembersAdminsOnly(enabled);
        detail = enabled ? 'Somente admins podem adicionar participantes.' : 'Participantes tambem podem adicionar membros.';
      } else if (action === 'get_invite_link') {
        if (typeof chat.getInviteCode !== 'function') throw new Error('Metodo getInviteCode indisponivel.');
        const code = String((await chat.getInviteCode()) || '').trim();
        detail = code ? `Link de convite atualizado: https://chat.whatsapp.com/${code}` : 'Nao consegui obter o link de convite agora.';
      } else if (action === 'refresh_invite_link') {
        if (typeof chat.revokeInvite !== 'function') throw new Error('Metodo revokeInvite indisponivel.');
        await chat.revokeInvite();
        let code = '';
        if (typeof chat.getInviteCode === 'function') {
          code = String((await chat.getInviteCode()) || '').trim();
        }
        detail = code
          ? `Link de convite renovado: https://chat.whatsapp.com/${code}`
          : 'Link de convite renovado com sucesso.';
      } else if (action === 'list_membership_requests') {
        if (typeof client.getGroupMembershipRequests !== 'function') {
          throw new Error('Metodo getGroupMembershipRequests indisponivel.');
        }
        const requests = await client.getGroupMembershipRequests(groupId);
        detail = `Solicitacoes pendentes: ${Array.isArray(requests) ? requests.length : 0}.`;
      } else if (action === 'approve_membership_requests') {
        if (typeof client.approveGroupMembershipRequests !== 'function') {
          throw new Error('Metodo approveGroupMembershipRequests indisponivel.');
        }
        const options = requesterIds.length ? { requesterIds } : undefined;
        await client.approveGroupMembershipRequests(groupId, options);
        detail = requesterIds.length
          ? `Solicitacoes aprovadas para ${requesterIds.length} numero(s).`
          : 'Solicitacoes pendentes aprovadas.';
      } else if (action === 'reject_membership_requests') {
        if (typeof client.rejectGroupMembershipRequests !== 'function') {
          throw new Error('Metodo rejectGroupMembershipRequests indisponivel.');
        }
        const options = requesterIds.length ? { requesterIds } : undefined;
        await client.rejectGroupMembershipRequests(groupId, options);
        detail = requesterIds.length
          ? `Solicitacoes rejeitadas para ${requesterIds.length} numero(s).`
          : 'Solicitacoes pendentes rejeitadas.';
      } else {
        throw new Error(`Acao de grupo nao suportada: ${action}`);
      }
    } catch (error) {
      res.status(400).json({
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    const snapshot = await buildGroupSnapshot({ includeInvite: true, includeRequests: true });
    if (!snapshot.ok) {
      res.status(snapshot.status || 400).json(snapshot);
      return;
    }

    res.json({
      ok: true,
      detail,
      ...snapshot
    });
  });

  app.get('/api/access-control', async (req, res) => {
    await accessControl.ensureReady();
    res.json({
      ok: true,
      accessControl: accessControl.snapshot(getPrimaryGroupId())
    });
  });

  app.get('/api/access-control/recent-senders', async (req, res) => {
    await accessControl.ensureReady();

    const fallbackGroupId = getPrimaryGroupId();
    const requestedGroupId = normalizeAccessGroup(String(req.query.groupId || '').trim());
    const groupId = requestedGroupId || fallbackGroupId;
    const limit = parseIntSafe(req.query.limit, 120, 20, 500);

    if (!groupId) {
      res.json({
        ok: true,
        groupId: '',
        total: 0,
        items: [],
        updatedAt: new Date().toISOString()
      });
      return;
    }

    const entries = await listRecentConversationEntries(groupId, limit);
    const bySender = new Map();
    const snapshot = accessControl.snapshot(getPrimaryGroupId());
    const staticAuthorized = new Set(Array.isArray(snapshot.staticAuthorized) ? snapshot.staticAuthorized : []);
    const staticAdmins = new Set(Array.isArray(snapshot.staticAdmins) ? snapshot.staticAdmins : []);
    const staticFulls = new Set(Array.isArray(snapshot.staticFulls) ? snapshot.staticFulls : []);

    for (const entry of entries) {
      if (String(entry?.direction || '') !== 'inbound') continue;
      const number = normalizeConversationSender(entry);
      if (!number) continue;

      const text = String(entry?.text || '').trim();
      const ts = String(entry?.ts || '').trim();
      const current = bySender.get(number) || {
        number,
        messages: 0,
        lastAt: '',
        lastPreview: ''
      };

      current.messages += 1;
      if (!current.lastAt || (ts && ts >= current.lastAt)) {
        current.lastAt = ts || current.lastAt;
        current.lastPreview = text ? text.slice(0, 180) : '';
      }

      bySender.set(number, current);
    }

    const items = Array.from(bySender.values())
      .sort((left, right) => String(right.lastAt || '').localeCompare(String(left.lastAt || '')))
      .map((item) => {
        const number = item.number;
        return {
          number,
          messages: item.messages,
          lastAt: item.lastAt,
          lastPreview: item.lastPreview,
          flags: {
            authorized: accessControl.isAuthorized(number),
            admin: accessControl.isAdmin(number),
            full: accessControl.isFull(number),
            private: accessControl.isPrivateAllowed(number),
            fixedAuthorized: staticAuthorized.has(number),
            fixedAdmin: staticAdmins.has(number),
            fixedFull: staticFulls.has(number)
          }
        };
      });

    res.json({
      ok: true,
      groupId,
      total: items.length,
      items,
      updatedAt: new Date().toISOString()
    });
  });

  app.get('/api/response-routing', async (req, res) => {
    await accessControl.ensureReady();
    res.json({
      ok: true,
      routing: buildResponseRoutingSnapshot()
    });
  });

  app.get('/api/response-routing/diagnostics', async (req, res) => {
    try {
      const diagnostics = await buildResponseRoutingDiagnostics();
      res.json({
        ok: true,
        diagnostics
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.post('/api/response-routing/groups', async (req, res) => {
    await accessControl.ensureReady();
    const groupId = normalizeAccessGroup(req.body?.groupId || req.body?.id || '');
    if (!groupId) {
      res.status(400).json({ ok: false, message: 'Group ID invalido.' });
      return;
    }

    const result = await accessControl.addResponseGroup(groupId);
    if (result.added) syncRuntimeRoutingState();
    res.status(result.added ? 200 : 400).json({
      ok: result.added,
      ...result,
      routing: buildResponseRoutingSnapshot()
    });
  });

  app.delete('/api/response-routing/groups/:groupId', async (req, res) => {
    await accessControl.ensureReady();
    const groupId = normalizeAccessGroup(decodeURIComponent(String(req.params.groupId || '')));
    if (!groupId) {
      res.status(400).json({ ok: false, message: 'Group ID invalido.' });
      return;
    }

    const result = await accessControl.removeResponseGroup(groupId);
    if (result.removed) syncRuntimeRoutingState();
    res.status(result.removed ? 200 : 400).json({
      ok: result.removed,
      ...result,
      routing: buildResponseRoutingSnapshot()
    });
  });

  app.post('/api/response-routing/private', async (req, res) => {
    await accessControl.ensureReady();
    const number = normalizeAccessPhone(req.body?.number || '');
    if (!number) {
      res.status(400).json({ ok: false, message: 'Numero invalido.' });
      return;
    }

    const result = await accessControl.addPrivate(number);
    if (result.added) syncRuntimeRoutingState();
    res.status(result.added ? 200 : 400).json({
      ok: result.added,
      ...result,
      routing: buildResponseRoutingSnapshot()
    });
  });

  app.delete('/api/response-routing/private/:number', async (req, res) => {
    await accessControl.ensureReady();
    const number = normalizeAccessPhone(decodeURIComponent(String(req.params.number || '')));
    if (!number) {
      res.status(400).json({ ok: false, message: 'Numero invalido.' });
      return;
    }

    const result = await accessControl.removePrivate(number);
    if (result.removed) syncRuntimeRoutingState();
    res.status(result.removed ? 200 : 400).json({
      ok: result.removed,
      ...result,
      routing: buildResponseRoutingSnapshot()
    });
  });

  app.post('/api/access-control/authorized', async (req, res) => {
    await accessControl.ensureReady();
    const number = normalizeAccessPhone(req.body?.number || '');
    if (!number) {
      res.status(400).json({ ok: false, message: 'Numero invalido.' });
      return;
    }

    const result = await accessControl.addAuthorized(number);
    res.status(result.added ? 200 : 400).json({
      ok: result.added,
      ...result,
      accessControl: accessControl.snapshot()
    });
  });

  app.delete('/api/access-control/authorized/:number', async (req, res) => {
    await accessControl.ensureReady();
    const number = normalizeAccessPhone(decodeURIComponent(String(req.params.number || '')));
    if (!number) {
      res.status(400).json({ ok: false, message: 'Numero invalido.' });
      return;
    }

    const result = await accessControl.removeAuthorized(number);
    res.status(result.removed ? 200 : 400).json({
      ok: result.removed,
      ...result,
      accessControl: accessControl.snapshot()
    });
  });

  app.post('/api/access-control/admins', async (req, res) => {
    await accessControl.ensureReady();
    const number = normalizeAccessPhone(req.body?.number || '');
    if (!number) {
      res.status(400).json({ ok: false, message: 'Numero invalido.' });
      return;
    }

    const result = await accessControl.addAdmin(number);
    res.status(result.added ? 200 : 400).json({
      ok: result.added,
      ...result,
      accessControl: accessControl.snapshot()
    });
  });

  app.delete('/api/access-control/admins/:number', async (req, res) => {
    await accessControl.ensureReady();
    const number = normalizeAccessPhone(decodeURIComponent(String(req.params.number || '')));
    if (!number) {
      res.status(400).json({ ok: false, message: 'Numero invalido.' });
      return;
    }

    const result = await accessControl.removeAdmin(number);
    res.status(result.removed ? 200 : 400).json({
      ok: result.removed,
      ...result,
      accessControl: accessControl.snapshot()
    });
  });

  app.post('/api/access-control/full', async (req, res) => {
    await accessControl.ensureReady();
    const number = normalizeAccessPhone(req.body?.number || '');
    if (!number) {
      res.status(400).json({ ok: false, message: 'Numero invalido.' });
      return;
    }

    const result = await accessControl.addFull(number);
    res.status(result.added ? 200 : 400).json({
      ok: result.added,
      ...result,
      accessControl: accessControl.snapshot()
    });
  });

  app.delete('/api/access-control/full/:number', async (req, res) => {
    await accessControl.ensureReady();
    const number = normalizeAccessPhone(decodeURIComponent(String(req.params.number || '')));
    if (!number) {
      res.status(400).json({ ok: false, message: 'Numero invalido.' });
      return;
    }

    const result = await accessControl.removeFull(number);
    res.status(result.removed ? 200 : 400).json({
      ok: result.removed,
      ...result,
      accessControl: accessControl.snapshot()
    });
  });

  // ─── Inbox: mensagens de nao autorizados ─────────────────────────────────────
  app.get('/api/inbox', (req, res) => {
    const messages = inbox ? inbox.getMessages() : [];
    res.json({ ok: true, messages });
  });

  app.post('/api/inbox/reply', async (req, res) => {
    const chatId = String(req.body?.chatId || '').trim();
    const text = String(req.body?.text || '').trim();
    if (!chatId || !text) {
      res.status(400).json({ ok: false, message: 'chatId e text sao obrigatorios.' });
      return;
    }
    if (!inbox?.sendReply) {
      res.status(503).json({ ok: false, message: 'Inbox nao disponivel.' });
      return;
    }
    try {
      await inbox.sendReply(chatId, text);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ ok: false, message: String(error?.message || error) });
    }
  });

  app.post('/api/inbox/authorize', async (req, res) => {
    const number = String(req.body?.number || '').replace(/\D/g, '').trim();
    if (!number) {
      res.status(400).json({ ok: false, message: 'number obrigatorio.' });
      return;
    }
    const result = await accessControl.grantAuthorized(number);
    if (!result.ok && result.reason !== 'exists') {
      res.status(400).json(result);
      return;
    }
    res.json({ ok: true, number, accessControl: accessControl.snapshot() });
  });
  // ─────────────────────────────────────────────────────────────────────────────

  app.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });

    res.write('\n');
    clients.add(res);

    sseEvent(res, 'state', getRuntimeState());
    sseEvent(res, 'full_jobs', getFullAutoJobsSnapshot());

    for (const item of getRecentLogs()) {
      sseEvent(res, 'log', item);
    }

    req.on('close', () => {
      clients.delete(res);
      res.end();
    });
  });

  function broadcast(event, payload) {
    for (const client of clients) {
      sseEvent(client, event, payload);
    }
  }

  const onLog = (entry) => broadcast('log', entry);
  const onState = (state) => broadcast('state', state);
  const onFullJobs = (snapshot) => broadcast('full_jobs', snapshot);

  logEvents.on('log', onLog);
  stateEvents.on('state', onState);
  fullAutoJobEvents.on('update', onFullJobs);

  const server = app.listen(config.port, () => {
    const localUrl = buildLocalPanelUrl();
    logger.info('Painel web online', { url: localUrl });

    void resolvePanelAccessInfo()
      .then((panelInfo) => {
        if (panelInfo.baseUrl !== localUrl) {
          logger.info('Painel web publico detectado', {
            url: panelInfo.baseUrl,
            menuUrl: panelInfo.menuUrl,
            source: panelInfo.source
          });
        }
      })
      .catch(() => {
        // Mantem apenas o log local quando o IP publico nao puder ser resolvido.
      });
  });

  return {
    emitInboxMessage: (entry) => broadcast('inbox_message', entry),
    close: () => {
      logEvents.off('log', onLog);
      stateEvents.off('state', onState);
      fullAutoJobEvents.off('update', onFullJobs);

      return new Promise((resolveClose) => {
        server.close(() => resolveClose());
      });
    }
  };
}
