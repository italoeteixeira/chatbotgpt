import { logger } from './logger.js';
import { getCodexCircuitStatus } from './codexBridge.js';
import { listFullAutoJobs, updateFullAutoJob } from './fullAutoJobStore.js';
import { getCopilotUsageSummary } from './copilotUsageTracker.js';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { config } from './config.js';

const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000; // heartbeat a cada 30 min
const RETRY_CHECK_INTERVAL_MS = 90 * 1000;    // verifica fila a cada 90s
const STALE_JOB_CHECK_INTERVAL_MS = 5 * 60 * 1000; // verifica jobs travados a cada 5 min
const MAX_RETRY_AGE_MS = 8 * 60 * 1000;       // mensagens expiram em 8 min
const MAX_QUEUE_SIZE = 15;
// Jobs 'running' com mais de 95 min são considerados travados (FULL_TIMEOUT_MAX=90min + buffer)
const STALE_JOB_THRESHOLD_MS = 95 * 60 * 1000;

let _client = null;
let _askAI = null;
let _getNotifGroupJid = null;
let _heartbeatTimer = null;
let _retryTimer = null;
let _staleJobTimer = null;
let _circuitWasOpen = false;

/** @type {Array<{groupId:string,text:string,aiContext:object,mention:string,enqueuedAt:number,attempts:number}>} */
const retryQueue = [];

const HEARTBEAT_MODEL_TEST_TIMEOUT_MS = 20000;

const HEARTBEAT_PROVIDER_MATRIX = {
  copilot: ['gpt-5-mini', 'gpt-4.1', 'gpt-5', 'claude-sonnet-4.6', 'claude-3.7-sonnet'],
  codex: ['gpt-5.4-mini', 'gpt-5.4', 'gpt-5-mini', 'gpt-5']
};

/**
 * Inicia o watchdog de auto-recuperacao.
 */
export function startWatchdog(client, askAI, getNotifGroupJid) {
  _client = client;
  _askAI = askAI;
  _getNotifGroupJid = getNotifGroupJid;
  _circuitWasOpen = false;
  clearInterval(_heartbeatTimer);
  clearInterval(_retryTimer);
  clearInterval(_staleJobTimer);
  _heartbeatTimer = setInterval(() => void _sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
  _retryTimer = setInterval(() => void _processRetryQueue(), RETRY_CHECK_INTERVAL_MS);
  _staleJobTimer = setInterval(() => void _killStaleJobs(), STALE_JOB_CHECK_INTERVAL_MS);
  logger.info('[SelfHealing] Watchdog iniciado - monitoramento ativo');
}

export function stopWatchdog() {
  clearInterval(_heartbeatTimer);
  clearInterval(_retryTimer);
  clearInterval(_staleJobTimer);
  _heartbeatTimer = null;
  _retryTimer = null;
  _staleJobTimer = null;
  logger.info('[SelfHealing] Watchdog encerrado');
}

/**
 * Marca todos os jobs 'running' como 'error'. Chamar no shutdown ou no init.
 */
export function markStaleJobsAsError(reason = 'Processo reiniciado com jobs em execucao.') {
  try {
    const jobs = listFullAutoJobs({ limit: 200 });
    let count = 0;
    for (const job of jobs) {
      if (job.status === 'running') {
        updateFullAutoJob(job.id, {
          status: 'error',
          error: reason,
          updatedAt: Date.now()
        });
        count++;
      }
    }
    if (count > 0) {
      logger.warn('[SelfHealing] Jobs orfaos marcados como error', { count, reason });
    }
  } catch (err) {
    logger.warn('[SelfHealing] Falha ao marcar jobs orfaos', {
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Verifica estado do circuit breaker e notifica grupo se mudou.
 * Chamar quando IA retornar fallback.
 */
export function checkAndNotifyCircuit() {
  try {
    const { open, failures } = getCodexCircuitStatus();
    if (open && !_circuitWasOpen) {
      _circuitWasOpen = true;
      void _notifyGroup(
        `\u26a0\ufe0f *Bot em modo lento*\n${failures} falha(s) detectadas na IA.\n` +
          'Trabalhando em background para recuperar. ' +
          'Mensagens pendentes serao enviadas assim que a IA normalizar.'
      );
    } else if (!open && _circuitWasOpen) {
      _circuitWasOpen = false;
      const pending = retryQueue.length;
      void _notifyGroup(
        `\u2705 *IA recuperada*\n` +
          (pending > 0
            ? `Processando ${pending} mensagem(ns) pendente(s) na fila...`
            : 'Sistema operando normalmente.')
      );
    }
  } catch {
    // nao bloqueia fluxo principal
  }
}

/**
 * Enfileira mensagem para retry em background quando IA voltar.
 */
export function queueRetry(groupId, text, aiContext, mention) {
  if (!groupId || !text) return;
  if (retryQueue.length >= MAX_QUEUE_SIZE) {
    retryQueue.shift(); // descarta o mais antigo
  }
  retryQueue.push({
    groupId,
    text,
    aiContext,
    mention: mention || '',
    enqueuedAt: Date.now(),
    attempts: 0
  });
  logger.info('[SelfHealing] Mensagem enfileirada para retry', { groupId, queueLen: retryQueue.length });
}

export async function notifyDisconnect(reason) {
  await _notifyGroup(
    `\u26a0\ufe0f *WhatsApp desconectado*\nMotivo: ${String(reason || 'desconhecido')}\n` +
      'O sistema tentara reconectar automaticamente.'
  );
}

export async function notifyAuthFailure(msg) {
  await _notifyGroup(
    `\ud83d\udd34 *Falha de autenticacao WhatsApp*\n${String(msg || 'sem detalhes')}\n` +
      'Pode ser necessario escanear o QR code novamente.'
  );
}

export async function notifyPreCrash(errorMsg) {
  await _notifyGroup(
    `\ud83d\udd34 *Bot encerrando por erro critico*\n${String(errorMsg || '').slice(0, 300)}\n\n` +
      'Systemd reiniciara em instantes.'
  );
}

// ─── Internos ────────────────────────────────────────────────────────────────

async function _processRetryQueue() {
  if (!_client || !_askAI || retryQueue.length === 0) return;

  const { open, remainingMs } = getCodexCircuitStatus();
  if (open) {
    logger.debug('[SelfHealing] Circuit aberto, aguardando cooldown', { remainingMs });
    return;
  }

  const batch = retryQueue.splice(0, Math.min(3, retryQueue.length));

  for (const item of batch) {
    const ageMs = Date.now() - item.enqueuedAt;
    if (ageMs > MAX_RETRY_AGE_MS) {
      logger.warn('[SelfHealing] Retry expirado, notificando usuario', { groupId: item.groupId, ageMs });
      try {
        const prefix = item.mention ? `${item.mention} ` : '';
        await _client.sendMessage(
          item.groupId,
          `${prefix}_Sua solicitacao anterior nao pode ser processada a tempo. Por favor, envie novamente._`
        );
      } catch {}
      continue;
    }

    logger.info('[SelfHealing] Processando retry', { groupId: item.groupId, attempts: item.attempts });
    try {
      const response = await _askAI(item.text, item.aiContext);
      if (_isFallback(response) && item.attempts < 2) {
        item.attempts++;
        retryQueue.unshift(item);
        logger.warn('[SelfHealing] Retry ainda falhou, reenfileirando', {
          groupId: item.groupId,
          attempts: item.attempts
        });
      } else {
        const prefix = item.mention ? `${item.mention} ` : '';
        const header = `\ud83d\udcec _Resposta anterior processada em background:_\n\n`;
        await _client.sendMessage(item.groupId, `${prefix}${header}${response}`);
        logger.info('[SelfHealing] Retry entregue com sucesso', { groupId: item.groupId });
      }
    } catch (err) {
      logger.error('[SelfHealing] Erro ao processar retry', {
        error: err instanceof Error ? err.message : String(err)
      });
      item.attempts++;
      if (item.attempts < 3) retryQueue.unshift(item);
    }
  }
}

async function _killStaleJobs() {
  try {
    const jobs = listFullAutoJobs({ limit: 200 });
    const now = Date.now();
    for (const job of jobs) {
      if (job.status !== 'running') continue;
      const startedAt = job.startedAt || job.updatedAt || 0;
      const ageMs = now - startedAt;
      if (ageMs < STALE_JOB_THRESHOLD_MS) continue;

      logger.warn('[SelfHealing] Job FULL travado detectado, marcando como error', {
        jobId: job.id,
        ageMs,
        thresholdMs: STALE_JOB_THRESHOLD_MS
      });
      updateFullAutoJob(job.id, {
        status: 'error',
        error: `Timeout de segurança: job estava em execução por ${Math.round(ageMs / 60000)} min sem concluir.`,
        updatedAt: now
      });
      void _notifyGroup(
        `⚠️ *Job FULL abortado automaticamente*\n` +
        `ID: ${job.id}\n` +
        `Em execução há: ${Math.round(ageMs / 60000)} min\n` +
        `Status: marcado como erro. O bot continua operando normalmente.`
      );
    }
  } catch (err) {
    logger.warn('[SelfHealing] Erro no scanner de jobs travados', {
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

async function _sendHeartbeat() {
  if (!_client) return;
  try {
    const { open, remainingMs, failures } = getCodexCircuitStatus();
    const uptimeMin = Math.floor(process.uptime() / 60);
    const queueLen = retryQueue.length;
    const circuitLabel = open
      ? `Em recuperacao (${Math.ceil((remainingMs || 0) / 1000)}s rest., ${failures} falha(s))`
      : 'Operando normalmente';
    const usageSummary = getCopilotUsageSummary();
    const availabilityLines = await _buildHeartbeatModelAvailabilityLines();
    const lines = [
      `\ud83e\udd16 *Heartbeat do Bot*`,
      `IA: ${circuitLabel}`,
      `Uptime: ${uptimeMin} min`,
      `Fila pendentes: ${queueLen}`,
      `🔢 Copilot: ${usageSummary}`,
      '',
      ...availabilityLines,
      `Data: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`
    ];
    await _notifyGroup(lines.join('\n'));
  } catch (err) {
    logger.error('[SelfHealing] Falha no heartbeat', {
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

async function _notifyGroup(text) {
  if (!_client || !_getNotifGroupJid) return;
  try {
    const jid = _getNotifGroupJid();
    if (!jid) return;
    await _client.sendMessage(jid, text);
  } catch (err) {
    logger.warn('[SelfHealing] Falha ao enviar notificacao', {
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

function _isFallback(response) {
  const lc = String(response || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return (
    lc.includes('lentidao') ||
    lc.includes('nao consegui concluir') ||
    lc.includes('tente novamente')
  );
}

function _trimToSingleLine(text, max = 90) {
  const normalized = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}

function _isCopilotAvailableFromOutput(result) {
  if (!result || result.exitCode !== 0) return false;
  if (result.stdout) return true;
  const errLc = String(result.stderr || '').toLowerCase();
  if (!errLc) return false;
  if (
    errLc.includes('402') ||
    errLc.includes('no quota') ||
    errLc.includes('not available') ||
    errLc.includes('error:') ||
    errLc.includes('usage:')
  ) {
    return false;
  }
  return true;
}

function _classifyModelProbe(providerId, model, result) {
  if (result?.timedOut) {
    return {
      ok: false,
      line: `${model} ❌ indisponivel (timeout ${HEARTBEAT_MODEL_TEST_TIMEOUT_MS}ms)`
    };
  }

  if (result?.spawnError) {
    return {
      ok: false,
      line: `${model} ❌ indisponivel (${_trimToSingleLine(result.spawnError, 70)})`
    };
  }

  if (providerId === 'copilot') {
    const errLc = String(result?.stderr || '').toLowerCase();
    if (errLc.includes('402') || errLc.includes('no quota')) {
      return { ok: false, line: `${model} ❌ sem quota (402)` };
    }
    if (errLc.includes('not available')) {
      return { ok: false, line: `${model} ❌ indisponivel (model not available)` };
    }
    if (_isCopilotAvailableFromOutput(result)) {
      return { ok: true, line: `${model} ✅ disponivel (${result.elapsedMs}ms)` };
    }
    if (result?.exitCode !== 0) {
      return { ok: false, line: `${model} ❌ indisponivel (exit ${result.exitCode})` };
    }
    return {
      ok: false,
      line: `${model} ❌ indisponivel (${_trimToSingleLine(result?.stderr || result?.stdout || 'sem saida', 70)})`
    };
  }

  if (result?.exitCode === 0 && String(result?.stdout || '').trim()) {
    return { ok: true, line: `${model} ✅ disponivel (${result.elapsedMs}ms)` };
  }

  return {
    ok: false,
    line: `${model} ❌ indisponivel no seu Codex CLI atual`
  };
}

function _runCommandProbe({ bin, args, input = '', timeoutMs = HEARTBEAT_MODEL_TEST_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    if (!bin || !existsSync(bin)) {
      resolve({
        exitCode: null,
        elapsedMs: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        spawnError: `binario nao encontrado: ${bin || '(vazio)'}`
      });
      return;
    }

    const startedAt = Date.now();
    const child = spawn(bin, args, {
      cwd: config.codexWorkdir,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        elapsedMs: Date.now() - startedAt,
        stdout,
        stderr,
        timedOut: false,
        spawnError: err instanceof Error ? err.message : String(err)
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        elapsedMs: Date.now() - startedAt,
        stdout: _trimToSingleLine(stdout, 180),
        stderr: _trimToSingleLine(stderr, 180),
        timedOut,
        spawnError: ''
      });
    });

    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

async function _probeModelAvailability(providerId, model) {
  const prompt = 'Responda apenas: teste ok';
  if (providerId === 'copilot') {
    return _runCommandProbe({
      bin: config.copilotBin,
      args: ['-p', prompt, '-s', '--no-color', '--no-ask-user', '--model', model]
    });
  }
  return _runCommandProbe({
    bin: config.codexBin,
    args: ['exec', '-', '--skip-git-repo-check', '--color', 'never', '-m', model, '--ephemeral'],
    input: prompt
  });
}

async function _buildHeartbeatModelAvailabilityLines() {
  const lines = ['🧪 *Disponibilidade de modelos (teste real)*'];

  for (const providerId of ['copilot', 'codex']) {
    lines.push(providerId === 'copilot' ? 'Copilot:' : 'Codex:');
    const models = HEARTBEAT_PROVIDER_MATRIX[providerId] || [];
    for (const model of models) {
      const probe = await _probeModelAvailability(providerId, model);
      const classification = _classifyModelProbe(providerId, model, probe);
      lines.push(`- ${classification.line}`);
    }
  }

  return lines;
}
